// kanban (the 4th desktop view type) — the ON-DEMAND half of the layout.
//
// Nothing imports this module statically: the eager bundle carries only the gate in
// kanban-lazy.js, which dynamic-`import()`s the asset built from this file the first
// time a `.base` really renders a kanban view. So a document without one never
// requests the asset, and the first-screen ratchet pays nothing for the layout.
// Precedents: features/reader/mermaid-runtime.js (same build shape, ESM, own asset)
// and features/canvas/canvas.js.
//
// What lives here is exactly what kanban adds on top of the other layouts: the board
// and column boxes, the `columnWidth` slider domain, the empty/error lines and their
// CSS. The cards themselves are the eager cards layout's own item, handed in as
// `primitives.createCardItem`, so field formatting (ƒ marker, dates, links, chips)
// keeps ONE implementation instead of a second copy inside this asset.
//
// Desktop evidence (asar 1.14.4, evidence/kanban-asar-windows.txt in the lane root):
// `columnWidth` slider `min:200,max:500,step:10,default:280` (@3171058 / @3157503),
// read-side fallback for a non-number or <=0 (@3168424), `labelGroupKeyNone:"None"`
// (`i18n@118874`) and `textNoGroupBy:"Choose a property to group by."`.
//
// Column ORDER is never re-derived here: it is the DTO's `groups[]` order, i.e. the
// server's `groupBy.direction` (SEMANTICS-FROZEN P9). `groupOrder` stays ignored
// (matrix N5) — it is a row-set whitelist filter in the desktop, not an order.
export const KANBAN_NO_GROUP_TEXT = "This Kanban view has no columns: add a groupBy property to the view.";
export const KANBAN_NO_GROUPS_TEXT = "No groups to show.";

// The desktop slider domain for kanban's own option (asar @3171058 `v7=280`).
export const KANBAN_COLUMN_WIDTH = { min: 200, max: 500, step: 10, fallback: 280 };

// Injected at runtime by the gate, exactly like canvas.js: app.css stays untouched, so
// the eager stylesheet pays nothing for a surface that may never be opened.
export const KANBAN_BOARD_CSS = `
.base-kanban-wrap{flex:1 1 auto;min-height:0;max-height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;}
.bases-kanban-pending{color:var(--text-faint);padding:6px 10px;}
.bases-kanban-board{display:flex;gap:12px;align-items:flex-start;padding:4px 20px;}
.bases-kanban-column{display:flex;flex-direction:column;flex:0 0 var(--base-kanban-column-width,280px);width:var(--base-kanban-column-width,280px);border:1px solid var(--background-modifier-border,var(--line));border-radius:8px;background:var(--background-secondary,var(--panel));}
.bases-kanban-column-header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--background-modifier-border,var(--line));font-size:13px;font-weight:600;color:var(--text-normal,var(--text));}
.bases-kanban-column-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.bases-kanban-column-count,.bases-kanban-column-empty,.bases-kanban-empty,.base-kanban-error{color:var(--text-faint);font-variant-numeric:tabular-nums;}
.bases-kanban-column-body{display:flex;flex-direction:column;gap:8px;padding:8px;min-height:28px;}
.bases-kanban-column-body .bases-cards-item{background:var(--background-primary,var(--panel));}
.bases-kanban-column-empty,.bases-kanban-empty,.base-kanban-error{padding:6px 10px;}
`;

const STYLE_ATTR = "data-kanban-surface";

export function injectKanbanStyles(doc = globalThis.document) {
  if (!doc?.createElement || !doc.head || doc.querySelector?.(`style[${STYLE_ATTR}]`)) return null;
  const style = doc.createElement("style");
  style.setAttribute(STYLE_ATTR, "");
  style.textContent = KANBAN_BOARD_CSS;
  doc.head.append(style);
  return style;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Desktop slider semantics: a non-number or non-positive value falls back to the
// default, otherwise the value is clamped into the slider's own range.
export function resolveKanbanOptions(stored) {
  const options = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const raw = options.columnWidth;
  const number = typeof raw === "number" ? raw : Number(raw);
  return {
    columnWidth: !Number.isFinite(number) || number <= 0
      ? KANBAN_COLUMN_WIDTH.fallback
      : clamp(number, KANBAN_COLUMN_WIDTH.min, KANBAN_COLUMN_WIDTH.max),
  };
}

// Absent stays absent: `null` is what tells the board the view has no grouping at all,
// so an undeclared document must never become `[]` (a legal, empty partition).
export function normalizeKanbanGroups(groups) {
  if (!Array.isArray(groups)) return null;
  return groups.filter((group) => group && typeof group === "object").map((group) => ({
    key: group.key === undefined ? null : group.key,
    keyType: typeof group.keyType === "string" ? group.keyType : null,
    count: Number.isSafeInteger(group.count) ? group.count : 0,
    rowPaths: Array.isArray(group.rowPaths) ? group.rowPaths.filter((path) => typeof path === "string") : [],
  }));
}

/**
 * Builds the board. `node` is what the gate mounts, `board` is the row host (null when
 * the view fails closed, so a later page append can never land on an error line).
 * `options` carries the cards layout's own resolved options (its item is reused); the
 * kanban-only `columnWidth` is merged in from the raw stored config.
 */
export function buildKanbanBoard({ doc, state, columns, options, host, primitives, storedOptions }) {
  if (!Array.isArray(state.groups)) {
    host.rowHost = null;
    const error = doc.createElement("div");
    error.className = "base-kanban-error";
    error.setAttribute("role", "alert");
    error.setAttribute("data-kanban-error", "no-group-by");
    error.textContent = KANBAN_NO_GROUP_TEXT;
    return { node: error, board: null };
  }
  const groups = state.groups;
  const boardOptions = { ...options, ...resolveKanbanOptions(storedOptions) };
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const indexByPath = new Map();
  rows.forEach((row, index) => { if (row && typeof row.path === "string") indexByPath.set(row.path, index); });
  const board = doc.createElement("div");
  board.className = "bases-kanban-board";
  board.setAttribute("data-base-kanban", "");
  board.setAttribute("data-kanban-columns", String(groups.length));
  board.style.setProperty("--base-kanban-column-width", `${boardOptions.columnWidth}px`);
  groups.forEach((group) => {
    const column = doc.createElement("div");
    column.className = "bases-kanban-column";
    column.setAttribute("data-group-key-type", String(group.keyType ?? "null"));
    column.setAttribute("data-group-count", String(group.count));
    const header = doc.createElement("div");
    header.className = "bases-kanban-column-header";
    const label = doc.createElement("span");
    label.className = "bases-kanban-column-label";
    // Keyless group = desktop's `labelGroupKeyNone:"None"` (P20). Text only.
    label.textContent = group.key === null || group.key === undefined ? "None" : String(group.key);
    const count = doc.createElement("span");
    count.className = "bases-kanban-column-count";
    count.textContent = String(group.count);
    header.appendChild(label);
    header.appendChild(count);
    column.appendChild(header);
    const body = doc.createElement("div");
    body.className = "bases-kanban-column-body";
    for (const path of group.rowPaths ?? []) {
      const index = indexByPath.get(path);
      // A member off the current page window is skipped; `count` stays the DTO's.
      if (index === undefined) continue;
      body.appendChild(primitives.createCardItem(rows[index], columns, index, boardOptions));
    }
    if (!body.childNodes.length) {
      const empty = doc.createElement("div");
      empty.className = "bases-kanban-column-empty";
      empty.textContent = "No rows in this group.";
      body.appendChild(empty);
    }
    column.appendChild(body);
    board.appendChild(column);
  });
  if (!groups.length) {
    const empty = doc.createElement("div");
    empty.className = "bases-kanban-empty";
    empty.textContent = KANBAN_NO_GROUPS_TEXT;
    board.appendChild(empty);
  }
  host.rowHost = board;
  return { node: board, board };
}
