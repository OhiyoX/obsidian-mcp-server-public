// Shared viewport-aware popup placement for sidebar chrome.
//
// The sidebar is `overflow: hidden`, so a popup laid out inside it is clipped as soon as
// it is wider than the sidebar or runs past the viewport — the search-syntax help card
// lost 48px of itself that way and the Explorer sort menu would lose more. Sidebar
// popups therefore position themselves from viewport coordinates, clamped into the
// visible area, with a bounded height and an upward flip when the room below is short,
// following the same pattern as `ui/select.js`.
export const POPUP_GAP = 4;
export const POPUP_MARGIN = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Pure layout for one measured trigger rect + viewport. `align` picks which trigger edge
// the popup follows ("end" = right-aligned, "start" = left-aligned).
export function computePopupLayout({
  trigger,
  viewport,
  maxWidth = 320,
  minWidth = 0,
  maxHeight = 420,
  minHeight = 120,
  preferredHeight = 280,
  align = "end",
} = {}) {
  const margin = POPUP_MARGIN;
  const gap = POPUP_GAP;
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  const triggerLeft = Number(trigger?.left) || 0;
  const triggerRight = Number(trigger?.right) || 0;
  const triggerTop = Number(trigger?.top) || 0;
  const triggerBottom = Number(trigger?.bottom) || 0;

  const availableWidth = Math.max(0, viewportWidth - margin * 2);
  const width = clamp(maxWidth, Math.min(minWidth, availableWidth), availableWidth);
  const anchor = align === "start" ? triggerLeft + width : triggerRight;
  const left = clamp(Math.round(anchor - width), margin, Math.max(margin, viewportWidth - margin - width));

  const roomBelow = viewportHeight - triggerBottom - gap - margin;
  const roomAbove = triggerTop - gap - margin;
  const openUp = roomBelow < preferredHeight && roomAbove > roomBelow;
  const boundedHeight = clamp(
    Math.round(openUp ? roomAbove : roomBelow),
    Math.min(minHeight, Math.max(0, viewportHeight - margin * 2)),
    maxHeight,
  );

  return { left, top: Math.round(openUp ? triggerTop - gap : triggerBottom + gap), width, maxHeight: boundedHeight, openUp };
}

// Applies a layout with `position: fixed`, so no ancestor `overflow` can clip it.
export function applyPopupLayout(element, layout) {
  element.style.position = "fixed";
  element.style.right = "auto";
  element.style.left = `${layout.left}px`;
  element.style.top = `${layout.top}px`;
  element.style.width = `${layout.width}px`;
  element.style.maxHeight = `${layout.maxHeight}px`;
  element.style.transform = layout.openUp ? "translateY(-100%)" : "none";
}
