// Host wiring for the note-context unlinked-mentions section (U2).
//
// Mirrors `attach-incoming.js`: `unlinked.js` stays presentation-only and is driven
// by `setDocument` / `clear`, while this module supplies the API client, the document
// switch seam and the identity guard. The guard matters because
// `refreshOutlineFromSource()` runs on every debounced editor change; without it each
// keystroke would re-fetch the API and flash the loading state. `setDocument` is a
// no-op when the path/kind/vault identity is unchanged; `clear()` resets the guard so
// re-opening the same note loads again. `refresh()` is exposed for an explicit reload.
import { createUnlinkedMentions, UNLINKED_MESSAGES } from "./unlinked.js";

const IDLE_MESSAGE = UNLINKED_MESSAGES.idle;
const BASE_MESSAGE = UNLINKED_MESSAGES.base;

function defaultFetchUnlinked(fetchImpl) {
  return ({ path, signal }) => fetchImpl(
    `/api/web/v1/note-context/unlinked?path=${encodeURIComponent(path)}`,
    { signal },
  ).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
}

export function attachUnlinkedMentions({
  host,
  openNote,
  vaultId = null,
  getVaultId,
  fetchImpl = globalThis.fetch,
  countHost = null,
} = {}) {
  const readVaultId = typeof vaultId === "function"
    ? vaultId
    : typeof getVaultId === "function"
      ? getVaultId
      : () => vaultId;
  const controller = createUnlinkedMentions({
    host,
    fetchUnlinked: defaultFetchUnlinked(fetchImpl),
    openNote,
    countHost,
  });
  let currentKey = null;

  function setDocument({ path, documentKind = "note" } = {}) {
    if (documentKind === "base" || !path) {
      controller.clear(documentKind === "base" ? BASE_MESSAGE : IDLE_MESSAGE);
      currentKey = null;
      return controller.getState();
    }
    const key = `${documentKind}:${path}:${readVaultId() ?? ""}`;
    if (key === currentKey) return controller.getState();
    currentKey = key;
    return controller.setDocument({ path, vaultId: readVaultId(), documentKind: "note" });
  }

  function clear(text = IDLE_MESSAGE) {
    currentKey = null;
    controller.clear(text);
  }

  function refresh() {
    return controller.refresh();
  }

  return { setDocument, clear, refresh, destroy: controller.destroy };
}
