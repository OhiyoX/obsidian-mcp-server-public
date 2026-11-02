// Per-column sort marker on the Base table header (lane desktop-re/bases-header-parity).
//
// Desktop truth (pinned 1.14.4 extract; byte offsets are the asar file's, not line numbers):
//   * render tail, app.js@3231419 —
//       `h = this.view.config.getSort().find(t => t.property === e);
//        h ? (n.setAttr("data-sort", h.direction),
//             LM(o, "ASC" === h.direction ? "lucide-chevron-up" : "lucide-chevron-down"))
//          : (n.setAttr("data-sort", null), o.empty());`
//     ⇒ `data-sort` carries "ASC"/"DESC"; an unsorted column carries NO attribute;
//   * the marker box `td > div.bases-table-header-sort` is created on the HEADER CELL
//     (app.js@3227612) and styled at app.css@489702.
//
// The list is the SORT PANEL's own (`effectiveSortList`: the `?sort=` override, else the
// sort the `.base` declares for the selected view) — one source of truth, never a copy.
import { createSpriteIcon } from "./cell.js";
import { effectiveSortList } from "./panel-sort.js";

// `column key -> "ASC" | "DESC"`; the first entry for a key wins (the panel paints one row
// per property, so a duplicate would be a server-side impossibility, not a rule to invent).
export function columnSortDirections(state) {
  const directions = new Map();
  for (const entry of effectiveSortList(state)) {
    if (!entry || typeof entry.key !== "string" || !entry.key) continue;
    if (!directions.has(entry.key)) directions.set(entry.key, entry.dir === "desc" ? "DESC" : "ASC");
  }
  return directions;
}

// One call per header cell: `data-sort` when the column is sorted, plus the marker box.
// The cell layout is a flat `<th>` (icon + label + resizer), so the desktop's sibling
// `div.bases-table-header-sort` is appended here and positioned absolutely by CSS.
export function decorateHeaderCell(doc, th, key, state) {
  const direction = columnSortDirections(state).get(key) ?? null;
  if (!direction) return null;
  th.setAttribute("data-sort", direction);
  th.appendChild(createSortMarker(doc, direction));
  return direction;
}

// The desktop glyphs are `lucide-chevron-up` (ASC) / `lucide-chevron-down` (DESC). The
// shipped sprite (app/src/app/assets/icons.svg) has NO `chevron-up` symbol, so ASC reuses the
// canonical `chevron-down` rotated 180deg in CSS instead of inventing path data; the marker's
// `data-sort-glyph` names the sprite symbol actually used (HANDOFF-HEADER-PARITY.md).
export function createSortMarker(doc, direction) {
  const box = doc.createElement("div");
  box.className = "bases-table-header-sort";
  box.setAttribute("data-sort-glyph", "chevron-down");
  if (direction === "ASC") box.setAttribute("data-sort-direction", "asc");
  const glyph = createSpriteIcon(doc, "chevron-down", "svg-icon bases-table-header-sort-icon");
  if (glyph) box.appendChild(glyph);
  return box;
}
