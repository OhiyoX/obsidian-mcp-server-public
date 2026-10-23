// U29 (#371): the workspace document tab row is a conditional chrome band.
//
// `features/tabs` owns the committed tab model; this module only mirrors that model onto
// `.workspace`, so the row (the second chrome band, directly under the single topbar) is in the
// layout exactly while the strip has a tab to show. A welcome workspace — or a Base opened
// first, where the tab model is still empty — therefore keeps one bar, and the row node itself
// stays in the DOM either way (the `features/tabs` seam and the shell contract keep their
// anchors). `core/app.js` calls `sync()` at the same three committed-identity seams that
// reconcile the strip, so the row can never drift from the model it mirrors.
export const TAB_ROW_VISIBLE_CLASS = "has-document-tabs";

export function createDocumentTabRow({ workspace = globalThis.document?.querySelector?.(".workspace") ?? null } = {}) {
  if (!workspace?.classList) return { isWired: false, sync: () => false };
  return {
    isWired: true,
    /** Mirror the committed tab list (`tabs.getState().tabs`) onto the row. */
    sync(tabs = []) {
      const visible = Array.isArray(tabs) ? tabs.length > 0 : Boolean(tabs);
      workspace.classList.toggle(TAB_ROW_VISIBLE_CLASS, visible);
      return visible;
    },
  };
}
