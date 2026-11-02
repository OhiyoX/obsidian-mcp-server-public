// Base cell codec. Two layers on purpose:
//   1. `describeCellValue` / `previewText` are pure and unit-testable;
//   2. `createCellNode` is the only place that touches the DOM, and it builds
//      elements exclusively through DOM APIs + `textContent`.
//
// Every value, view name, column label and formula display name is untrusted
// (WB-10). Nothing here may use innerHTML/insertAdjacentHTML.

export const EMPTY_CELL_TOKEN = "—";
export const MAX_CHIP_ITEMS = 3;
export const MAX_OBJECT_ENTRIES = 4;
export const MAX_PREVIEW_DEPTH = 2;

// A structured link cell is the ONLY value shape that may become clickable. A
// plain string that merely looks like [[link]] stays plain text.
export function isAsLinkCell(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.kind === "asLink"
    && typeof value.path === "string"
    && value.path.length > 0;
}

// Locale short form with padded day/month, matching features/document/property-value.js
// (e.g. en-US "10/04/2026", zh-CN "2026/10/04"). Kept local so the Base module
// stays independent of the Markdown document stack (surface-contract boundary);
// both copies are pinned by the same test matrix so they cannot drift apart.
//
// The authored calendar day must survive any timezone: a `Date` instance from
// js-yaml (unquoted date-only YAML = UTC midnight) uses its UTC components, and an
// ISO datetime keeps the day from its own date part — the same rule the desktop
// applies by normalizing date-only values to `T00:00:00`.
const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_CALENDAR_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;

const padPart = (value, width = 2) => String(value).padStart(width, "0");

function calendarParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible calendar dates (2026-02-31) instead of letting Date roll them over.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { iso: `${padPart(year, 4)}-${padPart(month)}-${padPart(day)}`, date };
}

export function isoDateParts(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = calendarParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    if (!parts) return null;
    const time = value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0 || value.getUTCMilliseconds() !== 0;
    return { ...parts, time, datetime: value.toISOString(), instant: time ? value : undefined };
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = ISO_CALENDAR_DATE.exec(text);
  if (dateOnly) {
    const parts = calendarParts(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
    return parts ? { ...parts, time: false, datetime: parts.iso } : null;
  }
  const dateTime = ISO_CALENDAR_DATETIME.exec(text);
  if (!dateTime) return null;
  const [, iso, clock, zone = ""] = dateTime;
  const parts = calendarParts(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
  if (!parts) return null;
  const instant = new Date(`${iso}T${clock}${zone}`);
  if (Number.isNaN(instant.getTime())) return null;
  return { ...parts, time: true, datetime: text, instant };
}

export function formatDateValue(value) {
  const parsed = isoDateParts(value);
  if (parsed) return formatCalendar(parsed.iso);
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      const [year, month, day] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
      return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
    }
    return value;
  }
  return String(value ?? "");
}

// Desktop Bases show the calendar day through moment `L` (asar app.js `renderTo`:
// `window.moment(this.date).format(this.time ? "L LT" : "L")`), which for the en-US table the
// owner shot uses (`04-sort-popover.png`: `10/21/2026`) is `MM/DD/YYYY` — no spaces around the
// slashes. The padded numbers are kept; only the separators change.
function formatCalendar(iso) {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

// Bounded, non-executing textual preview used for array chips, object summaries
// and nested values. Depth-bounded so a cyclic/deep object cannot hang the UI.
export function previewText(value, depth = 0) {
  if (value === null || value === undefined) return EMPTY_CELL_TOKEN;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (depth >= MAX_PREVIEW_DEPTH) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_CHIP_ITEMS).map((item) => previewText(item, depth + 1));
    const extra = value.length - items.length;
    return extra > 0 ? `${items.join(", ")}, +${extra}` : items.join(", ");
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const shown = keys.slice(0, MAX_OBJECT_ENTRIES).map((key) => `${key}: ${previewText(value[key], depth + 1)}`);
    const extra = keys.length - shown.length;
    return extra > 0 ? `${shown.join(", ")}, +${extra}` : shown.join(", ");
  }
  return String(value);
}

function describeArrayItem(item) {
  if (isAsLinkCell(item)) {
    const displayName = typeof item.displayName === "string" && item.displayName.length ? item.displayName : item.path;
    return { text: displayName, link: { path: item.path, displayName } };
  }
  return { text: previewText(item), link: null };
}

// A value is shown as a date when it is a bare ISO calendar date or an ISO
// timestamp (YAML dates become JS Dates upstream and are serialized as
// `YYYY-MM-DDT00:00:00.000Z`). The displayed calendar day is the source date part,
// so a timezone offset can never shift the visible day.
function dateDescriptor(value, columnKind) {
  if (typeof value === "string" || value instanceof Date) {
    const parsed = isoDateParts(value);
    if (parsed) return { type: "date", value, iso: parsed.iso, text: formatDateValue(parsed.iso) };
  }
  if (columnKind === "date") return { type: "date", value, iso: value, text: formatDateValue(value) };
  return null;
}

// Pure classifier. Returns a descriptor union consumed by createCellNode.
export function describeCellValue(value, columnKind = null) {
  if (value === null || value === undefined) return { type: "empty", text: EMPTY_CELL_TOKEN };

  if (isAsLinkCell(value)) {
    const displayName = typeof value.displayName === "string" && value.displayName.length ? value.displayName : value.path;
    return { type: "link", path: value.path, displayName, text: displayName };
  }

  const date = dateDescriptor(value, columnKind);
  if (date) return date;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_CHIP_ITEMS).map(describeArrayItem);
    return { type: "array", items, overflow: Math.max(0, value.length - items.length) };
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    const entries = keys.slice(0, MAX_OBJECT_ENTRIES).map((key) => ({ key, text: previewText(value[key], 1) }));
    return { type: "object", entries, overflow: Math.max(0, keys.length - entries.length) };
  }

  if (typeof value === "number") return { type: "number", text: String(value) };
  if (typeof value === "boolean") return { type: "boolean", value, text: String(value) };
  if (typeof value === "string") return { type: "string", text: value };
  return { type: "string", text: String(value) };
}

function textSpan(doc, className, text) {
  const node = doc.createElement("span");
  node.className = className;
  node.textContent = String(text ?? "");
  return node;
}

function createLinkNode(doc, { path, displayName }, onOpenNote) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "base-cell-link";
  // Wave C browser-contract hook (A5 selectors.linkCell).
  button.setAttribute("data-cell-kind", "link");
  button.textContent = displayName;
  button.onclick = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onOpenNote?.({ path });
  };
  return button;
}

// U38 (#571): one sprite builder for the whole app — the URL (with its published content
// hash) comes from ui/icons.js. Returns null on DOM implementations without SVG support (the
// Node test harness) so callers can degrade to text-only.
import { spriteIcon } from "../../ui/icons.js";

// Kept under this name because the Base surfaces and their tests import it from here.
export { spriteIcon as createSpriteIcon };

function calendarIcon(doc) {
  return spriteIcon(doc, "calendar", "svg-icon base-cell-date-icon");
}

function createDateNode(doc, descriptor) {
  const time = doc.createElement("time");
  time.className = "base-cell-date";
  const iso = typeof descriptor.iso === "string" ? descriptor.iso : null;
  if (iso) {
    time.setAttribute("datetime", iso);
    time.title = iso;
  }
  const glyph = calendarIcon(doc);
  if (glyph) time.appendChild(glyph);
  time.appendChild(doc.createTextNode(String(descriptor.text ?? "")));
  return time;
}

function createArrayNode(doc, descriptor, onOpenNote) {
  const wrap = doc.createElement("span");
  wrap.className = "base-cell-array";
  for (const item of descriptor.items) {
    if (item.link) {
      const chip = createLinkNode(doc, item.link, onOpenNote);
      chip.className = "base-cell-link base-cell-chip";
      wrap.appendChild(chip);
    } else {
      wrap.appendChild(textSpan(doc, "base-cell-chip", item.text));
    }
  }
  if (descriptor.overflow > 0) wrap.appendChild(textSpan(doc, "base-cell-more", `+${descriptor.overflow}`));
  return wrap;
}

function createObjectNode(doc, descriptor) {
  const wrap = doc.createElement("span");
  wrap.className = "base-cell-object";
  for (const entry of descriptor.entries) {
    wrap.appendChild(textSpan(doc, "base-cell-object-entry", `${entry.key}: ${entry.text}`));
  }
  if (descriptor.overflow > 0) wrap.appendChild(textSpan(doc, "base-cell-more", `+${descriptor.overflow}`));
  return wrap;
}

// DOM layer: descriptor -> element. `onOpenNote({ path })` is the only navigation
// affordance and is only wired for canonical asLink values.
export function createCellNode(doc, descriptor, { onOpenNote } = {}) {
  if (!descriptor) return textSpan(doc, "base-cell-empty", EMPTY_CELL_TOKEN);
  switch (descriptor.type) {
    case "link":
      return createLinkNode(doc, descriptor, onOpenNote);
    case "array":
      return createArrayNode(doc, descriptor, onOpenNote);
    case "object":
      return createObjectNode(doc, descriptor);
    case "boolean": {
      const node = textSpan(doc, "base-cell-bool", descriptor.text);
      node.setAttribute("role", "checkbox");
      node.setAttribute("aria-checked", String(Boolean(descriptor.value)));
      node.setAttribute("aria-readonly", "true");
      return node;
    }
    case "date":
      return createDateNode(doc, descriptor);
    case "number":
      return textSpan(doc, "base-cell-number", descriptor.text);
    case "empty":
      return textSpan(doc, "base-cell-empty", descriptor.text);
    case "string":
    default:
      return textSpan(doc, "base-cell-text", descriptor.text);
  }
}
