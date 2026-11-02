// Document-level keyboard shortcuts, extracted so `core/app.js` stays within the
// architecture line budget: Escape closes transient menus, Ctrl/Cmd+S saves the open
// note, Ctrl/Cmd+R resolves a conflict by reloading from disk.
//
// Web Bases convergence: a Base document has no save path, so Ctrl/Cmd+S must be a
// proven no-op there (preventDefault, no write request). `getDocumentKind` defaults to
// the note behavior so Markdown shortcuts are unchanged.
export function initializeKeyboardShortcuts({
  session,
  viewMode,
  documentActions,
  saveButton,
  onSave,
  onReload,
  getDocumentKind = () => null,
  scope = globalThis.document,
} = {}) {
  scope.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      viewMode?.closeMenu?.();
      documentActions?.closeMenu?.();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      if (getDocumentKind() === "base") return;
      if (!saveButton?.disabled) onSave?.();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r" && session?.conflict) {
      event.preventDefault();
      onReload?.({ force: false });
    }
  });
}
