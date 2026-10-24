// Coarse-pointer capability seam for the Base table (issue #337 Cut 3).
//
// One place decides "is the primary pointer a finger", so the two touch policies
// of the table can never drift apart: the resize handle is hidden *and* never
// wired, the rows get a 44px touch target, and a tap on a cell selects its row.
// The window is injected (the surface already threads `windowObject` for deep
// links) so the decision is unit-testable and the Node harness — which has no
// `matchMedia` — keeps the desktop behaviour.
//
// Failure mode is deliberately "fine pointer": a window we cannot interrogate
// keeps the desktop table instead of inventing touch affordances. No user-agent
// sniffing (D337-02).

export const COARSE_POINTER_QUERY = "(pointer: coarse)";

export function isCoarsePointer(win = globalThis) {
  if (!win || typeof win.matchMedia !== "function") return false;
  try {
    return win.matchMedia(COARSE_POINTER_QUERY).matches === true;
  } catch {
    return false;
  }
}

// Pure selection transition for a tap on a row. Keys are opaque row identities
// (`row.path`); tapping the already selected row clears the selection, any other
// tap replaces it. `null` means "nothing selected".
export function nextSelectionKey(current, tapped) {
  if (tapped === null || tapped === undefined) return current ?? null;
  return current === tapped ? null : tapped;
}
