import { GFM, parser as markdownParser } from "@lezer/markdown";
import { Facet, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { renderTableCellEditing, renderTableCellIdle } from "./table-cell-render.js";
import { buildTableDOM, estimatedTableHeight } from "./table-surface-dom.js";
import { tableSurfaceGeometry } from "./table-surface-geometry.js";


const stableTableParser = markdownParser.configure(GFM);

/**
 * Per-editor measurement context. The holder object is created once per editor
 * instance and stays identical across state reconfigurations; only its `view` is
 * filled in as soon as that editor's EditorView exists. The table surface reads
 * the owning view from the model, so a widget measured for editor A can never
 * observe editor B's host, font or width. This deliberately is not a module
 * singleton: `state.facet()` returns the holder that was configured for that
 * editor's extension list.
 */
export const tableMeasurementContext = Facet.define({
  combine: (values) => (values.length ? values[0] : null),
});

function editableCellRange(state, cellNode) {
  const raw = state.sliceDoc(cellNode.from, cellNode.to);
  const leading = raw.match(/^\s*/u)?.[0]?.length || 0;
  const trailing = raw.match(/\s*$/u)?.[0]?.length || 0;
  const from = Math.min(cellNode.to, cellNode.from + leading);
  const to = Math.max(from, cellNode.to - trailing);
  return {
    from,
    to,
    value: state.sliceDoc(from, to),
  };
}

function rowCells(state, rowNode) {
  const cells = [];
  for (let child = rowNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableCell") continue;
    cells.push(editableCellRange(state, child));
  }
  return cells;
}

function delimiterAlignments(source, columnCount) {
  const lines = String(source || "").split(/\r?\n/u);
  const delimiter = lines.find((line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line)) || "";
  const body = delimiter.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const parts = body ? body.split("|") : [];
  return Array.from({ length: columnCount }, (_, index) => {
    const marker = String(parts[index] || "").trim();
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function adjacentBlankLines(state, tableNode) {
  const startLine = state.doc.lineAt(tableNode.from).number;
  const endProbe = Math.max(tableNode.from, tableNode.to - 1);
  const endLine = state.doc.lineAt(endProbe).number;
  return {
    before: startLine > 1 && state.doc.line(startLine - 1).text.trim() === "",
    after: endLine < state.doc.lines && state.doc.line(endLine + 1).text.trim() === "",
  };
}

function buildTableModel(state, tableNode) {
  const rows = [];
  for (let child = tableNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableHeader" && child.name !== "TableRow") continue;
    const cells = rowCells(state, child);
    if (!cells.length) continue;
    rows.push({ header: child.name === "TableHeader", cells });
  }
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const blankLines = adjacentBlankLines(state, tableNode);
  return {
    from: tableNode.from,
    to: tableNode.to,
    source: state.sliceDoc(tableNode.from, tableNode.to),
    rows,
    columnCount,
    blankBefore: blankLines.before,
    blankAfter: blankLines.after,
    alignments: delimiterAlignments(state.sliceDoc(tableNode.from, tableNode.to), columnCount),
    measurementContext: state.facet(tableMeasurementContext) || null,
  };
}

function cellSelector(row, col) {
  return `.cm-table-cell[data-table-row="${row}"][data-table-col="${col}"]`;
}

function updateCellDataset(element, cell, model, row, col) {
  element.dataset.tableRow = String(row);
  element.dataset.tableCol = String(col);
  const editor = element.querySelector(".cm-table-cell-editor");
  if (!editor) return;
  editor.dataset.sourceOffsetFrom = String(cell.from - model.from);
  editor.dataset.sourceOffsetTo = String(cell.to - model.from);
  editor.dataset.sourceValue = cell.value;
}

function sameShape(a, b) {
  return a.rows.length === b.rows.length
    && a.rows.every((row, index) => (
      row.header === b.rows[index].header
      && row.cells.length === b.rows[index].cells.length
    ));
}

class TableSurfaceWidget extends WidgetType {
  constructor(model) {
    super();
    this.model = model;
  }

  eq(other) {
    return other instanceof TableSurfaceWidget
      && other.model.from === this.model.from
      && other.model.source === this.model.source
      // blankBefore/blankAfter are not part of model.source but they change the
      // block padding, so an equal-length edit of an adjacent line must not be
      // allowed to reuse the previous widget (and its cached height).
      && other.model.blankBefore === this.model.blankBefore
      && other.model.blankAfter === this.model.blankAfter;
  }

  // CodeMirror virtualizes block widgets outside the viewport. Supplying a
  // realistic height estimate prevents the height map from treating an
  // offscreen table like one ordinary text line and then correcting the whole
  // document when the real DOM is first measured. The estimate is measured from
  // the owning editor's themed DOM (falling back to the fixed heuristic when no
  // view is available), so a non-default table font no longer disagrees with the
  // first painted frame.
  get estimatedHeight() {
    return estimatedTableHeight(this.model, this.model.measurementContext?.view || null);
  }

  toDOM(view) {
    return buildTableDOM(view, this.model);
  }

  updateDOM(dom, view, previous) {
    if (!(previous instanceof TableSurfaceWidget) || !sameShape(this.model, previous.model)) return false;
    dom.dataset.tableFrom = String(this.model.from);
    dom.dataset.tableTo = String(this.model.to);
    dom.dataset.tableBlankBefore = this.model.blankBefore ? "true" : "false";
    dom.dataset.tableBlankAfter = this.model.blankAfter ? "true" : "false";
    const active = dom.ownerDocument.activeElement;
    this.model.rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, colIndex) => {
        const element = dom.querySelector(cellSelector(rowIndex, colIndex));
        if (!element) return;
        element.style.textAlign = this.model.alignments[colIndex] || "left";
        const editor = element.querySelector(".cm-table-cell-editor");
        const activeEditing = editor === active && editor?.contentEditable === "true";
        const domValue = activeEditing ? String(editor.textContent ?? "").replace(/\u00a0/gu, " ") : "";
        updateCellDataset(element, cell, this.model, rowIndex, colIndex);
        if (activeEditing) {
          // A local input transaction already made DOM text === model text.
          // A clean external refresh/undo can legitimately change the model
          // underneath an active cell; never leave stale DOM as a second truth.
          if (domValue !== cell.value) renderTableCellEditing(editor, cell.value);
        } else if (editor) {
          renderTableCellIdle(editor, cell.value);
        }
      });
    });
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

function decorationsFromTables(tables) {
  return Decoration.set(tables.map(({ from, to, model }) => Decoration.replace({
    widget: new TableSurfaceWidget(model),
    block: true,
  }).range(from, to)), true);
}

function buildTableSurfaceState(state, tree) {
  const tables = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const model = buildTableModel(state, node.node);
      if (model.rows.length && model.columnCount) {
        tables.push({ from: node.from, to: node.to, model });
      }
      return false;
    },
  });
  return { tables, decorations: decorationsFromTables(tables) };
}


function buildStableTableSurfaceState(state) {
  // CodeMirror's editor language parser is intentionally viewport-incremental.
  // Replacement decorations that change block height cannot depend on that
  // lazy tree: otherwise a distant table is still raw text in the height map
  // until scrolling reaches it, and the late replacement visibly snaps the
  // document. Parse the table structure once for the whole document instead.
  return buildTableSurfaceState(state, stableTableParser.parse(state.doc.toString()));
}

function changesStayInsideKnownCells(value, transaction) {
  if (!transaction.docChanged || !value.tables.length) return false;
  let sawChange = false;
  let safe = true;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    sawChange = true;
    const owner = value.tables.find((table) => table.model.rows.some((row) => (
      row.cells.some((cell) => fromA >= cell.from && toA <= cell.to)
    )));
    if (!owner) {
      safe = false;
      return;
    }
    const removed = transaction.startState.sliceDoc(fromA, toA);
    const inserted = transaction.state.sliceDoc(fromB, toB);
    if (/\r|\n|\|/u.test(removed) || /\r|\n|\|/u.test(inserted)) safe = false;
  });
  return sawChange && safe;
}

function refreshKnownTableModels(value, transaction) {
  const tables = value.tables.map((table) => {
    const from = transaction.changes.mapPos(table.from, -1);
    const to = transaction.changes.mapPos(table.to, 1);
    const model = {
      ...table.model,
      from,
      to,
      source: transaction.state.sliceDoc(from, to),
      rows: table.model.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => {
          const cellFrom = transaction.changes.mapPos(cell.from, -1);
          const cellTo = transaction.changes.mapPos(cell.to, 1);
          return {
            from: cellFrom,
            to: cellTo,
            value: transaction.state.sliceDoc(cellFrom, cellTo),
          };
        }),
      })),
    };
    return { from, to, model };
  });
  return { tables, decorations: decorationsFromTables(tables) };
}

function mapUnchangedTables(value, changes) {
  const tables = value.tables.map((table) => ({
    ...table,
    from: changes.mapPos(table.from, 1),
    to: changes.mapPos(table.to, -1),
  }));
  // Preserve existing Widget instances when edits occur outside table
  // structure. This keeps ordinary prose typing O(number of decorations)
  // instead of reparsing/rebuilding every table in a long note.
  return { tables, decorations: value.decorations.map(changes) };
}

function lineNeighborhoodHasPipe(state, position) {
  const line = state.doc.lineAt(Math.max(0, Math.min(state.doc.length, position)));
  const first = Math.max(1, line.number - 1);
  const last = Math.min(state.doc.lines, line.number + 1);
  for (let number = first; number <= last; number += 1) {
    if (state.doc.line(number).text.includes("|")) return true;
  }
  return false;
}

function changeMayAlterTableStructure(value, transaction) {
  let structural = false;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (structural) return;

    // Existing table boundaries are structural by definition. Cell-only text
    // edits have already returned through changesStayInsideKnownCells().
    if (value.tables.some((table) => fromA <= table.to && toA >= table.from)) {
      structural = true;
      return;
    }

    // A new GFM table can only emerge around pipe-bearing source lines. Limit
    // the expensive full-document parse to the old/new changed-line
    // neighborhoods instead of reparsing a 10k-line note on every ordinary
    // prose newline.
    if (lineNeighborhoodHasPipe(transaction.startState, fromA)
      || lineNeighborhoodHasPipe(transaction.startState, toA)
      || lineNeighborhoodHasPipe(transaction.state, fromB)
      || lineNeighborhoodHasPipe(transaction.state, toB)) {
      structural = true;
    }
  });
  return structural;
}

const tableSurfaceField = StateField.define({
  create: buildStableTableSurfaceState,
  update(value, transaction) {
    if (transaction.reconfigured) return buildStableTableSurfaceState(transaction.state);
    // Parser background progress is deliberately ignored. Table replacement
    // topology is document state, not viewport state, and was fully established
    // by the stable parser before the first paint.
    if (!transaction.docChanged) return value;
    if (changesStayInsideKnownCells(value, transaction)) {
      return refreshKnownTableModels(value, transaction);
    }
    if (changeMayAlterTableStructure(value, transaction)) {
      return buildStableTableSurfaceState(transaction.state);
    }
    return mapUnchangedTables(value, transaction.changes);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    // The root document treats the replaced Markdown table as one atomic
    // block. Cell interaction is handled inside the widget and writes through
    // root transactions; root caret/drag selection skips the hidden source
    // interior instead of landing in geometry that has no line DOM.
    EditorView.atomicRanges.from(field, (value) => () => value.decorations),
  ],
});

/**
 * Table Surface v2: one GFM Table source range becomes one real HTML table.
 * The root EditorState remains the only Markdown source of truth.
 *
 * `measurementContext` is the per-editor `{ view }` holder created by the editor
 * factory. Without it (pure state fixtures, tests, server-side tooling) the
 * offscreen estimate uses the fixed heuristic instead of DOM measurement.
 */
export function obsidianTableSurface(measurementContext = null) {
  return [
    tableSurfaceField,
    tableSurfaceGeometry,
    ...(measurementContext ? [tableMeasurementContext.of(measurementContext)] : []),
    EditorView.contentAttributes.of({
      "data-obsidian-table-engine": "v2",
    }),
  ];
}
