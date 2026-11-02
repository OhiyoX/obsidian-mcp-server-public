// Issue #337 Cut 1 — the renderer's only touch seam.
//
// `prefetch-hover.js` binds two handlers onto every directory row because a hover binding
// is a row-owned property (`row.onpointerenter`). The touch seam cannot work that way: the
// lazy renderer rebuilds the whole row list on every render (`host.innerHTML = ""`), so a
// per-row handler would have to be re-attached on each paint and would be dropped by any
// re-render that happens while a finger is down. It is therefore delegated once on the
// list host — the row handlers the renderer already owns (`onclick`, hover) stay untouched
// and are composed with, never replaced.
//
// Bubble phase carries `pointerdown` / `pointermove` / `pointerup` / `pointercancel` from
// the row button; `pointerleave` does not bubble, so it is observed in the capture phase
// (where it is still delivered for the row the finger/pen is leaving). Nothing here cancels
// the native event or captures the pointer (I337-E02), so native scrolling, text selection
// and the click path behave exactly as before; the 100 ms window,
// the slop, the grace timer, the capability and every network rule stay in
// `prefetch-touch.js`, and this module only maps an event to the folder path of the row it
// happened on.
export const TOUCH_FOLDER_ROW_SELECTOR = ".tree-folder";
export const TOUCH_FOLDER_WRAP_SELECTOR = ".tree-folder-row";

// The add button is a sibling of the row button inside the same `.tree-folder-row` wrapper,
// so `closest(".tree-folder")` resolves only for the folder toggle itself — tapping `+`
// issues its own formal ensure/load and must not arm a touch prefetch.
export function folderPathFromEvent(event) {
  const target = event?.target;
  const row = typeof target?.closest === "function" ? target.closest(TOUCH_FOLDER_ROW_SELECTOR) : null;
  const wrap = typeof row?.closest === "function" ? row.closest(TOUCH_FOLDER_WRAP_SELECTOR) : null;
  const path = wrap?.dataset?.folderPath;
  return typeof path === "string" && path !== "" ? path : null;
}

export function bindFolderTouchIntent({ host, intent } = {}) {
  if (!host || typeof host.addEventListener !== "function" || !intent) return () => {};
  const forward = (handler) => (event) => {
    if (typeof handler === "function") handler(folderPathFromEvent(event), event);
  };
  const onPointerDown = forward(intent.pointerdown);
  const onPointerMove = forward(intent.pointermove);
  const onPointerUp = forward(intent.pointerup);
  const onPointerCancel = forward(intent.pointercancel);
  const onPointerLeave = forward(intent.pointerleave);
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerCancel);
  host.addEventListener("pointerleave", onPointerLeave, true);
  return () => {
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onPointerCancel);
    host.removeEventListener("pointerleave", onPointerLeave, true);
  };
}
