// Host wiring for the note-context incoming-links (backlinks) section.
//
// Mirrors `attach-outgoing.js`: `incoming.js` stays presentation-only and is driven
// by `setDocument` / `clear`, while this module supplies the API client, the document
// switch seam and the identity guard. The guard matters because
// `refreshOutlineFromSource()` runs on every debounced editor change; without it each
// keystroke would re-fetch the API and flash the loading state. `setDocument` is a
// no-op when the path/kind/vault identity is unchanged; `clear()` resets the guard so
// re-opening the same note loads again. `refresh()` is exposed for an explicit reload.
import { createIncomingLinks, INCOMING_MESSAGES } from "./incoming.js";

const IDLE_MESSAGE = INCOMING_MESSAGES.idle;
const BASE_MESSAGE = INCOMING_MESSAGES.base;

function defaultFetchIncoming(fetchImpl) {
  return ({ path, signal }) => fetchImpl(
    `/api/web/v1/note-context/incoming?path=${encodeURIComponent(path)}`,
    { signal },
  ).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
}

export function attachIncomingLinks({
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
  const controller = createIncomingLinks({
    host,
    fetchIncoming: defaultFetchIncoming(fetchImpl),
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
