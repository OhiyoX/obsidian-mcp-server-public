// Phase 2B-1b-i: map vault SSE events to per-parent lazy-Explorer invalidation.
//
// Frozen decision: SSE note events invalidate only the affected parent (or the
// current query), and `vault.resync` must NOT trigger a full-tree download. This
// adapter is pure (controller + callbacks injected) so the policy is unit-testable
// and the live-events controller can adopt it without changing its own contract.
const NOTE_EVENTS = new Set(["note.created", "note.changed", "note.deleted"]);

export function createLazyExplorerEvents({
  controller,
  isQueryActive = () => false,
  onSearchInvalidate = () => {},
  onAssetEvent = () => {},
  vaultId = null,
} = {}) {
  if (!controller) throw new Error("createLazyExplorerEvents requires a controller");

  function handle(event) {
    if (!event) return;
    if (vaultId && event.vaultId && event.vaultId !== vaultId) return;

    if (event.isAssetEvent || event.type === "asset.changed") {
      onAssetEvent(event);
      return;
    }
    if (event.isResync || event.type === "vault.resync") {
      // Mark everything stale and reload root once; never a per-note storm. An active
      // query also refreshes itself -- tree and search caches are independent, so a
      // resync must invalidate both, not one instead of the other.
      controller.invalidateEverything();
      if (isQueryActive()) onSearchInvalidate(event);
      return;
    }
    if (event.isNoteEvent || NOTE_EVENTS.has(event.type) || String(event.type || "").startsWith("note.")) {
      // Always keep the tree parent cache current; additionally refresh the active
      // query. A create/delete/change during search must not leave a stale parent
      // behind for when the search is cleared.
      if (event.path) controller.invalidate(event.path);
      if (isQueryActive()) onSearchInvalidate(event);
    }
  }

  return { handle };
}
