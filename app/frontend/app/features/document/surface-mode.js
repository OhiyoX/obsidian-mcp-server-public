/**
 * Document surfaces: CodeMirror for RAW and editable Live; HTML reader for Reading.
 */
export const SURFACE_MODES = Object.freeze({
  raw: "raw",
  live: "live",
  preview: "preview",
});

export function normalizeSurfaceMode(value) {
  if (value === SURFACE_MODES.preview) return SURFACE_MODES.preview;
  if (value === SURFACE_MODES.raw) return SURFACE_MODES.raw;
  return SURFACE_MODES.live;
}

export function isLiveSurface(mode) {
  return normalizeSurfaceMode(mode) === SURFACE_MODES.live;
}

export function isEditableSurface(mode) {
  return normalizeSurfaceMode(mode) === SURFACE_MODES.live;
}

export function surfaceUsesEditor(mode) {
  const normalized = normalizeSurfaceMode(mode);
  return normalized === SURFACE_MODES.raw || normalized === SURFACE_MODES.live;
}
