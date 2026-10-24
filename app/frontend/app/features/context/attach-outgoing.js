// Host wiring for the note-context outgoing-links section (E3 integration).
//
// `outgoing.js` stays presentation-only: it renders inside its own host and is driven
// by `setDocument` / `clear`. This attach module supplies the API client, the document
// switch seam and a small identity guard, so the application entry can drive the
// section from the same hook that refreshes the outline.
//
// The guard matters: `refreshOutlineFromSource()` runs on every (debounced) editor
// change, while outgoing links only depend on the open document. Without it each
// keystroke would re-fetch the API and flash the loading state. `setDocument` is a
// no-op when the path/kind/vault identity is unchanged; `clear()` resets the guard so
// re-opening the same note loads again. `refresh()` is exposed for an explicit reload.
import { createOutgoingLinks, OUTGOING_MESSAGES } from "./outgoing.js";

const IDLE_MESSAGE = OUTGOING_MESSAGES.idle;
const BASE_MESSAGE = OUTGOING_MESSAGES.base;

function defaultFetchOutgoing(fetchImpl) {
  return ({ path, signal }) => fetchImpl(
    `/api/web/v1/note-context/outgoing?path=${encodeURIComponent(path)}`,
    { signal },
  ).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
}

export function attachOutgoingLinks({
  host,
  openNote,
  vaultId = null,
  getVaultId,
  fetchImpl = globalThis.fetch,
  openAsset,
  getAssetUrl,
  countHost = null,
} = {}) {
  const readVaultId = typeof vaultId === "function"
    ? vaultId
    : typeof getVaultId === "function"
      ? getVaultId
      : () => vaultId;
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: defaultFetchOutgoing(fetchImpl),
    openNote,
    openAsset,
    getAssetUrl,
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
