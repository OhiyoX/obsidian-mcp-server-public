// U30 contract A1: the reader surface refuses uploads.
//
// This is an interceptor only — no new entry point, no upload affordance. A file dropped on
// rendered content would otherwise hit the browser's default action (navigating away to the
// local file), so `dragover` and `drop` are cancelled when they land inside the rendered
// reader surface (`.markdown-preview-view`, the container `core/app.js` renders into).
const READER_SURFACE = ".markdown-preview-view";

function insideReaderSurface(target) {
  const element = typeof Element !== "undefined" && target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest?.(READER_SURFACE));
}

/**
 * Installs the guard on `root` (the document by default) and returns its detach function.
 * A document-level capture listener keeps this independent of how the reader is mounted;
 * it never touches the editor, whose DOM is not inside the reader surface.
 */
export function installReaderAssetDropGuard(root = typeof document === "undefined" ? null : document) {
  if (!root?.addEventListener) return () => {};
  const onDragOver = (event) => {
    if (insideReaderSurface(event.target)) event.preventDefault();
  };
  const onDrop = (event) => {
    if (!insideReaderSurface(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("dragover", onDragOver, true);
  root.addEventListener("drop", onDrop, true);
  return () => {
    root.removeEventListener("dragover", onDragOver, true);
    root.removeEventListener("drop", onDrop, true);
  };
}
