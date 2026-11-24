// Shared horizontal wheel routing for a table's own scroll box.
//
// A wide table lives in a local scroller, but a mouse without a tilt wheel only
// sends a vertical delta. Both surfaces that own such a scroller (the Live table
// viewport and the Base table wrap) hand the gesture to this one function, so
// the Live editor and a Base table scroll the same way.

/**
 * The horizontal part of a wheel event in CSS pixels: `deltaX` first, the
 * vertical delta only while Shift is held, converted by `deltaMode`. Returns 0
 * when the event carries no horizontal intent, so a caller can leave the
 * gesture to native vertical scrolling.
 */
export function horizontalWheelDelta(event, viewport) {
  let delta = Number(event.deltaX) || 0;
  if (Math.abs(delta) < 0.5 && event.shiftKey) delta = Number(event.deltaY) || 0;
  if (Math.abs(delta) < 0.5) return 0;
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
  return delta * factor;
}

/**
 * Scroll `viewport` horizontally by the wheel event's horizontal intent and take
 * the gesture only when it really moved the scroller. Returns true when the
 * event was consumed (preventDefault + stopPropagation), false when nothing
 * happened, in which case the browser keeps its native vertical scroll.
 */
export function scrollTableHorizontally(event, viewport) {
  if (!viewport || viewport.scrollWidth <= viewport.clientWidth + 1) return false;
  const delta = horizontalWheelDelta(event, viewport);
  if (!delta) return false;
  const before = viewport.scrollLeft;
  viewport.scrollLeft += delta;
  if (Math.abs(viewport.scrollLeft - before) <= 0.5) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
