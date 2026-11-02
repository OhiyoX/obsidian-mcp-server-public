// Public entry for the self-contained, read-only Base surface.
//
// This module is intentionally NOT imported by core/app.js: B4 wires it through
// features/navigation/base-navigation.js. It has no dependency on the Markdown
// editor, document session, explorer, ui components or bundle entries.

export { createBaseSurface } from "./controller.js";
export { BASE_SURFACE_CSS } from "./view.js";
export { EMPTY_CELL_TOKEN, describeCellValue, previewText, formatDateValue, isAsLinkCell } from "./cell.js";
export { buildBaseRequestUrl, createBaseState, BASE_LIMIT_DEFAULT, BASE_LIMIT_MIN, BASE_LIMIT_MAX } from "./state.js";
export {
  BASE_FILTER_OPS,
  BASE_QUERY_MAX,
  BASE_SORT_MAX,
  buildBaseHref,
  buildBaseSearch,
  normalizeFilter,
  normalizeQuery,
  normalizeSort,
  parseBaseSearch,
} from "./query-state.js";
export {
  BASE_ACTION_ITEMS,
  BASE_FILTER_OP_LABELS,
  describeSortIndicator,
  folderOfPath,
} from "./toolbar.js";
export {
  BASE_VIEW_CONFIG_PREFIX,
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  baseViewConfigKey,
  clampColumnWidth,
  readViewConfig,
  toggleColumnVisibility,
  visibleColumns,
  withColumnWidth,
  writeViewConfig,
} from "./view-config.js";
