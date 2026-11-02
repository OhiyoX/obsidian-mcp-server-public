const NOTE_EVENTS = new Set(["note.created", "note.changed", "note.deleted"]);
const ASSET_EVENTS = new Set(["asset.changed"]);

function parseEventPayload(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeLiveEvent(type, payload) {
  if (!payload || typeof payload !== "object") return null;
  const eventType = String(payload.type || type || "");
  return {
    id: payload.id ?? null,
    type: eventType,
    vaultId: payload.vaultId ?? null,
    path: payload.path ?? "",
    revision: payload.revision ?? null,
    size: payload.size ?? null,
    modified: payload.modified ?? null,
    origin: payload.origin ?? null,
    mutationId: payload.mutationId ?? null,
    occurredAt: payload.occurredAt ?? null,
    isNoteEvent: NOTE_EVENTS.has(eventType) || eventType.startsWith("note."),
    isAssetEvent: ASSET_EVENTS.has(eventType) || eventType === "asset.changed",
    isResync: eventType === "vault.resync",
  };
}

export function createLiveUpdates({ onEvent, onStatus }) {
  let source = null;
  let stopped = false;

  function status(value) {
    onStatus?.(value);
  }

  function emit(type, raw) {
    const payload = parseEventPayload(raw);
    const event = normalizeLiveEvent(type, payload);
    if (!event) return;
    onEvent?.(event);
  }

  function connect() {
    if (stopped || source) return;
    status("connecting");
    source = new EventSource("/api/web/v1/events");
    source.addEventListener("hello", (event) => {
      status("live");
      emit("hello", event.data);
    });
    for (const type of ["note.created", "note.changed", "note.deleted", "asset.changed", "vault.resync"]) {
      source.addEventListener(type, (event) => {
        status("live");
        emit(type, event.data);
      });
    }
    source.onerror = () => status(navigator.onLine ? "reconnecting" : "paused");
  }

  function stop() {
    stopped = true;
    source?.close();
    source = null;
    status("paused");
  }

  window.addEventListener("online", () => {
    if (!stopped && !source) connect();
    else status("connecting");
  });
  window.addEventListener("offline", () => status("paused"));
  connect();
  return { stop, normalizeLiveEvent };
}

export { normalizeLiveEvent, parseEventPayload };
