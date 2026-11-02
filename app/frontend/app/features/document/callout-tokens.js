/*
 * Canonical Obsidian callout faces, extracted — not invented — from the local
 * Obsidian Desktop install:
 *
 *   <Obsidian>/resources/obsidian.asar -> app.css   (rules + `--callout-*`)
 *   <Obsidian>/resources/obsidian.asar -> app.js    (DOM + icon source)
 *
 * Provenance (Obsidian 1.13.7, app.css sha256 f612f1e8f36486fa…, app.js sha256
 * 8efbf581e259cabe…). app.css is a normal line-based file; app.js ships minified
 * on one line, so byte offsets are given instead of line numbers.
 *
 * Type table — app.css 11253-11326, verbatim:
 *   .callout                       { --callout-color: var(--callout-default); --callout-icon: lucide-pencil; }
 *   [data-callout="abstract"|"summary"|"tldr"]  { --callout-summary;  clipboard-list }
 *   [data-callout="info"]          { --callout-info;      lucide-info }
 *   [data-callout="todo"]          { --callout-todo;      lucide-check-circle-2 }
 *   [data-callout="important"]     { --callout-important; lucide-flame }
 *   [data-callout="tip"|"hint"]    { --callout-tip;       lucide-flame }
 *   [data-callout="success"|"check"|"done"] { --callout-success; lucide-check }
 *   [data-callout="question"|"help"|"faq"]  { --callout-question; help-circle }
 *   [data-callout="warning"|"caution"|"attention"] { --callout-warning; lucide-alert-triangle }
 *   [data-callout="failure"|"fail"|"missing"]      { --callout-fail;    lucide-x }
 *   [data-callout="danger"|"error"]        { --callout-error;   lucide-zap }
 *   [data-callout="bug"]           { --callout-bug;       lucide-bug }
 *   [data-callout="example"]       { --callout-example;   lucide-list }
 *   [data-callout="quote"|"cite"]  { --callout-quote;     quote-glyph }
 *
 * `quote-glyph` and `help-circle` are legacy glyph ids; Desktop's `getIcon`
 * resolves them through its glyph alias table (app.js @1035095,
 * `"quote-glyph":"quote"`) and adds the `svg-icon lucide-<resolved>` classes
 * (app.js `function Tg`, @1133xxx: `n.classList.add("svg-icon", e)`).
 *
 * Icon geometry — app.js lucide node table + its decoder `function wg`
 * (@1032600), copied here verbatim. Node encoding:
 *   [0, x1, y1, x2, y2] line | [1, cx, cy, r, fill?] circle | [2, points] polyline
 *   [3, points] polygon | [4, cx, cy, rx, ry] ellipse | [5, x, y, w, h, rx?, ry?, transform?] rect
 *   [6, d, fill?] path
 * The wrapper attributes are Desktop's own skeleton (app.js `var yg`):
 *   `.svg-icon` sizing/stroke still comes from app.css, exactly like Desktop.
 */

const SVG_SKELETON = 'width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Desktop lucide nodes, verbatim (app.js icon table). */
export const CALLOUT_LUCIDE_NODES = {
  pencil: [[6, "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"], [6, "m15 5 4 4"]],
  "clipboard-list": [[5, 8, 2, 8, 4, 1, 1], [6, "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"], [6, "M12 11h4"], [6, "M12 16h4"], [6, "M8 11h.01"], [6, "M8 16h.01"]],
  info: [[1, 12, 12, 10], [6, "M12 16v-4"], [6, "M12 8h.01"]],
  "check-circle-2": [[1, 12, 12, 10], [6, "m9 12 2 2 4-4"]],
  flame: [[6, "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"]],
  check: [[6, "M20 6 9 17l-5-5"]],
  "alert-triangle": [[6, "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"], [6, "M12 9v4"], [6, "M12 17h.01"]],
  x: [[6, "M18 6 6 18"], [6, "m6 6 12 12"]],
  zap: [[6, "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"]],
  bug: [[6, "M12 20v-9"], [6, "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"], [6, "M14.12 3.88 16 2"], [6, "M21 21a4 4 0 0 0-3.81-4"], [6, "M21 5a4 4 0 0 1-3.55 3.97"], [6, "M22 13h-4"], [6, "M3 21a4 4 0 0 1 3.81-4"], [6, "M3 5a4 4 0 0 0 3.55 3.97"], [6, "M6 13H2"], [6, "m8 2 1.88 1.88"], [6, "M9 7.13V6a3 3 0 1 1 6 0v1.13"]],
  list: [[6, "M3 5h.01"], [6, "M3 12h.01"], [6, "M3 19h.01"], [6, "M8 5h13"], [6, "M8 12h13"], [6, "M8 19h13"]],
  "help-circle": [[1, 12, 12, 10], [6, "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"], [6, "M12 17h.01"]],
  quote: [[6, "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"], [6, "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"]],
};

/* `data-callout` value -> { color: --callout-* token, icon: resolved lucide name }. */
export const CALLOUT_TYPES = [
  { types: ["abstract", "summary", "tldr"], color: "--callout-summary", icon: "clipboard-list" },
  { types: ["info"], color: "--callout-info", icon: "info" },
  { types: ["todo"], color: "--callout-todo", icon: "check-circle-2" },
  { types: ["important"], color: "--callout-important", icon: "flame" },
  { types: ["tip", "hint"], color: "--callout-tip", icon: "flame" },
  { types: ["success", "check", "done"], color: "--callout-success", icon: "check" },
  { types: ["question", "help", "faq"], color: "--callout-question", icon: "help-circle" },
  { types: ["warning", "caution", "attention"], color: "--callout-warning", icon: "alert-triangle" },
  { types: ["failure", "fail", "missing"], color: "--callout-fail", icon: "x" },
  { types: ["danger", "error"], color: "--callout-error", icon: "zap" },
  { types: ["bug"], color: "--callout-bug", icon: "bug" },
  { types: ["example"], color: "--callout-example", icon: "list" },
  { types: ["quote", "cite"], color: "--callout-quote", icon: "quote" },
];

/* Desktop's base `.callout` rule (app.css 11253-11255): pencil + --callout-default. */
export const DEFAULT_CALLOUT = { color: "--callout-default", icon: "pencil" };

const TYPE_INDEX = new Map();
for (const entry of CALLOUT_TYPES) for (const type of entry.types) TYPE_INDEX.set(type, entry);

/**
 * Desktop renderer for one icon node (app.js `function wg`).
 */
function nodeHtml(node) {
  const [tag, a, b, c, d, e, f, g] = node;
  if (tag === 0) return `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`;
  if (tag === 1) return `<circle cx="${a}" cy="${b}" r="${c}"${d ? ' fill="currentColor"' : ""}/>`;
  if (tag === 2) return `<polyline points="${escapeAttr(a)}"/>`;
  if (tag === 3) return `<polygon points="${escapeAttr(a)}"/>`;
  if (tag === 4) return `<ellipse cx="${a}" cy="${b}" rx="${c}" ry="${d}"/>`;
  if (tag === 5) {
    return `<rect x="${a}" y="${b}" width="${c}" height="${d}"${e ? ` rx="${e}"` : ""}${f ? ` ry="${f}"` : ""}${g ? ` transform="${escapeAttr(g)}"` : ""}/>`;
  }
  if (tag === 6) return `<path d="${escapeAttr(a)}"${b ? ' fill="currentColor"' : ""}/>`;
  return "";
}

/**
 * Canonical callout icon markup: an inline svg carrying Desktop's own
 * `svg-icon lucide-<name>` class face and skeleton attributes, so `.svg-icon`
 * sizing/stroke and `svg.lucide-*` theme rules keep working.
 */
export function calloutIconHtml(type) {
  const entry = TYPE_INDEX.get(String(type || "").trim().toLowerCase()) || DEFAULT_CALLOUT;
  const nodes = CALLOUT_LUCIDE_NODES[entry.icon];
  if (!nodes) return "";
  const body = nodes.map(nodeHtml).join("");
  return `<svg class="svg-icon lucide-${entry.icon}" ${SVG_SKELETON} aria-hidden="true">${body}</svg>`;
}

/** The `--callout-*` colour token Desktop's `[data-callout="…"]` rules select. */
export function calloutColorToken(type) {
  return (TYPE_INDEX.get(String(type || "").trim().toLowerCase()) || DEFAULT_CALLOUT).color;
}

/**
 * Desktop's default title (app.js @1363000): the type with dashes as spaces,
 * lowercased, first character uppercased — `[!check-circle]` -> "Check circle".
 */
export function calloutLabel(type) {
  const words = String(type || "").trim().replace(/-/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
