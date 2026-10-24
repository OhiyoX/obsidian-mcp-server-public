// Host wiring for the repository-level Tags panel.
//
// Resolves the real shell markup (`pages.js`) and owns the panel lifecycle. It is a
// no-op when the panel markup is absent, so fixtures without the Tags section keep
// working. The panel is Vault-scoped: `attachNoteContext` never clears it on a
// note/Base switch, and it loads once at attach time.
import { createTagsPanel } from "./tags.js";

export function attachTagsPanel({
  documentRef = globalThis.document,
  fetchImpl = globalThis.fetch,
  storage = null,
  load = true,
} = {}) {
  const pick = (selector) => documentRef?.querySelector?.(selector) ?? null;
  const panel = createTagsPanel({
    host: pick("#tags-list"),
    sortToggle: pick("#tags-sort-toggle"),
    sortMenu: pick("#tags-sort-menu"),
    filterToggle: pick("#tags-filter-toggle"),
    filterRow: pick(".tags-filter-row"),
    filterInput: pick("#tags-filter"),
    searchInput: pick("#search"),
    fetchImpl,
    storage,
    // The sort menu's popup listeners (outside dismissal, keyboard) must belong to the same
    // document the markup came from, not to the global one (U35 / #407).
    documentRef,
  });
  if (load) panel.load();
  return panel;
}
