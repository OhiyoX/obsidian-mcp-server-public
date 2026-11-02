// Column-boundary drag handles for the Base table.
//
// Desktop parity: the handle only shows on hover, dragging resizes the column and
// the width is persisted per (vault, base, view) by the caller. The table itself
// uses `table-layout: fixed`, so a `<colgroup>` width is authoritative and the
// sticky header plus the narrow-screen horizontal scroll keep working.
// Coarse pointer: the whole affordance is refused (see `attachColumnResize`).

import { isCoarsePointer } from "./pointer-policy.js";
import { clampColumnWidth, resolveColumnWidths } from "./view-config.js";

export const COLUMN_RESIZE_HANDLE_CLASS = "base-col-resize";

export function createColGroup(doc, columns, widths) {
  const group = doc.createElement("colgroup");
  for (const column of columns ?? []) {
    const col = doc.createElement("col");
    col.setAttribute("data-column", column.key);
    const width = clampColumnWidth(widths?.[column.key]);
    if (width !== null) col.style.width = `${width}px`;
    group.appendChild(col);
  }
  return group;
}

export function totalColumnWidth(columns, widths) {
  return (columns ?? []).reduce((sum, column) => {
    const width = clampColumnWidth(widths?.[column.key]);
    return sum + (width ?? 0);
  }, 0);
}

// Exposed so the view can install the handles it renders.
export function createResizeHandle(doc, columnKey, label) {
  const handle = doc.createElement("span");
  handle.className = COLUMN_RESIZE_HANDLE_CLASS;
  handle.setAttribute("data-column", String(columnKey ?? ""));
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `调整列宽：${label ?? columnKey ?? ""}`);
  handle.setAttribute("tabindex", "-1");
  return handle;
}

// `onPreview(key, width)` repaints while dragging; `onCommit(key, width)` persists
// once the drag ends. Both are optional so the module stays inert without a host.
//
// Coarse pointer (#337 Cut 3): the boundary drag is refused outright. The handle
// carries `touch-action:none`, so a finger landing on the 7px boundary would have
// its pan swallowed; the stylesheet hides the handle at the same capability and
// this early return is the second half of that policy (no listener set at all, so
// a handle that is somehow visible still cannot resize anything). There is no
// drag alternative in v1.
export function attachColumnResize({ headRow, columns, widths, onPreview, onCommit, windowObject = null } = {}) {
  const cleanups = [];
  if (!headRow || typeof headRow.querySelectorAll !== "function") return { destroy() {} };
  if (isCoarsePointer(windowObject ?? globalThis)) return { destroy() {}, disabled: true };
  const byKey = new Map((columns ?? []).map((column) => [column.key, column]));
  const resolved = resolveColumnWidths(columns, { widths });

  for (const handle of headRow.querySelectorAll(`.${COLUMN_RESIZE_HANDLE_CLASS}`)) {
    const key = handle.getAttribute("data-column");
    const column = byKey.get(key);
    if (!column) continue;
    let drag = null;

    const onPointerDown = (event) => {
      const startX = Number(event?.clientX);
      if (!Number.isFinite(startX)) return;
      event.preventDefault?.();
      drag = { startX, startWidth: resolved[key] ?? 0, width: resolved[key] ?? 0 };
      handle.setAttribute("data-dragging", "true");
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture is best-effort; the handle listeners below still work.
      }
    };
    const onPointerMove = (event) => {
      if (!drag) return;
      const x = Number(event?.clientX);
      if (!Number.isFinite(x)) return;
      event.preventDefault?.();
      const width = clampColumnWidth(drag.startWidth + (x - drag.startX));
      if (width === null || width === drag.width) return;
      drag.width = width;
      onPreview?.(key, width);
    };
    const endDrag = () => {
      if (!drag) return;
      const width = drag.width;
      drag = null;
      handle.removeAttribute("data-dragging");
      onCommit?.(key, width);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    cleanups.push(() => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", endDrag);
      handle.removeEventListener("pointercancel", endDrag);
    });
  }

  return {
    destroy() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}
