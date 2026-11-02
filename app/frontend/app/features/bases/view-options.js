// Desktop Bases per-view display options — READ side only.
//
// Desktop declares them in each view's own `getViewOptions`:
//   list  app.js@3182005: `markers` dropdown (bullet|number|none, default bullet),
//                         `indentProperties` toggle (default false),
//                         `separator` text (default ", ", hidden when the toggle is on)
//   cards app.js@3147490: `cardSize` slider 50..800/10 (default 200),
//                         `image` property picker, `imageFit` dropdown
//                         ("" = Cover | "contain" = Contain), `imageAspectRatio`
//                         slider 0.25..2.5/0.05 (default 1)
// The i18n labels are `i18n@118472` (list) / `i18n@118662` (cards).
//
// Read/write policy for this slice: the Web DTO carries only `{ name, type }` per
// view (app/src/base-query.js `listBaseViews`), so the private keys themselves are
// read from the per-(vault, base, view) client store (view-config.js) and fall back
// to the desktop defaults above. Writing them back into the `.base` file needs a
// write surface and is a separate slice (RECON §5 item 4); nothing here writes.

export const BASE_VIEW_TYPE_TABLE = "table";
export const BASE_VIEW_TYPE_LIST = "list";
export const BASE_VIEW_TYPE_CARDS = "cards";
export const BASE_VIEW_TYPE_KANBAN = "kanban";

export const LIST_MARKERS = ["bullet", "number", "none"];
export const LIST_MARKER_DEFAULT = "bullet";
export const LIST_SEPARATOR_DEFAULT = ", ";

// The non-table types this slice renders; everything else (including a null or
// unknown declared type) keeps the table surface, so the row set can never change
// with the view type (BASES-COMPATIBILITY-MATRIX §12.1).
const RENDERED_TYPES = [BASE_VIEW_TYPE_TABLE, BASE_VIEW_TYPE_LIST, BASE_VIEW_TYPE_CARDS, BASE_VIEW_TYPE_KANBAN];

export function normalizeViewType(type) {
  const value = typeof type === "string" ? type.trim().toLowerCase() : "";
  return RENDERED_TYPES.includes(value) ? value : BASE_VIEW_TYPE_TABLE;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Desktop slider semantics: a non-number or non-positive value falls back to the
// default, otherwise the value is clamped into the slider's own range.
function sliderValue(value, { min, max, fallback }) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return clamp(number, min, max);
}

function text(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

export const CARD_SIZE = { min: 50, max: 800, step: 10, fallback: 200 };
// kanban's own `columnWidth` slider domain lives in the on-demand asset
// (kanban-runtime.js KANBAN_COLUMN_WIDTH): the layout is not in this bundle.
export const IMAGE_ASPECT_RATIO = { min: 0.25, max: 2.5, step: 0.05, fallback: 1 };
export const IMAGE_FIT_COVER = "";
export const IMAGE_FIT_CONTAIN = "contain";

export function resolveViewOptions(viewType, stored) {
  const options = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const type = normalizeViewType(viewType);
  if (type === BASE_VIEW_TYPE_LIST) {
    return {
      markers: LIST_MARKERS.includes(options.markers) ? options.markers : LIST_MARKER_DEFAULT,
      indentProperties: options.indentProperties === true,
      separator: text(options.separator, LIST_SEPARATOR_DEFAULT),
    };
  }
  // kanban keeps the cards' own image options (desktop reuses `p7=h7.cards`), and the
  // kanban-only `columnWidth` is merged in by the layout's own asset. So a kanban view
  // resolves to the cards options here and the board is handed these -- one formatter,
  // one option domain, no second copy in the lazy asset.
  if (type === BASE_VIEW_TYPE_CARDS || type === BASE_VIEW_TYPE_KANBAN) {
    return {
      cardSize: sliderValue(options.cardSize, CARD_SIZE),
      // Desktop 1.14.4 never ships radar/2D media detection here: the picker only
      // accepts a property key, and no value means "no cover image".
      imageProperty: typeof options.image === "string" && options.image !== "" ? options.image : null,
      imageFit: options.imageFit === IMAGE_FIT_CONTAIN ? IMAGE_FIT_CONTAIN : IMAGE_FIT_COVER,
      imageAspectRatio: sliderValue(options.imageAspectRatio, IMAGE_ASPECT_RATIO),
    };
  }
  return {};
}

// The cover height desktop computes from the card width and the aspect ratio
// (`coverHeight` in the cards view); ratio 1 keeps the card square.
export function cardCoverHeight(options) {
  const size = sliderValue(options?.cardSize, CARD_SIZE);
  const ratio = sliderValue(options?.imageAspectRatio, IMAGE_ASPECT_RATIO);
  return Math.round(size / ratio);
}
