// Issue #284 B2 — the renderer's only hover seam.
//
// Directory rows only (§I10); a hover never expands, loads or reveals anything (§I02).
// The 150 ms intent window, the hover-capability check and every network rule live in
// the frozen A1 module (`prefetch.js`); this binding forwards the bare pointer event
// with the row's own path and nothing else. Binding is skipped when no intent is
// injected, so a bare render stays inert.
export function bindFolderHoverIntent(row, parent, intent) {
  if (!intent) return;
  row.onpointerenter = () => intent.pointerenter(parent);
  row.onpointerleave = () => intent.pointerleave(parent);
}
