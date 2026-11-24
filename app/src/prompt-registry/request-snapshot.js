// One prompt snapshot per MCP request.
//
// A publish can land between two reads inside one `tools/call`; the request must
// still describe itself consistently, so the registry snapshot is captured once at
// the protocol entry and carried in AsyncLocalStorage. Handlers read it instead of
// asking the store again.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/** Run `callback` with the registry's current snapshot pinned for this request. */
export function runWithPromptSnapshot(registry, callback) {
  if (registry === null || typeof registry?.snapshot !== "function") return callback();
  return storage.run({ snapshot: registry.snapshot() }, callback);
}

/** The snapshot pinned for the current request, or undefined outside one. */
export function currentPromptSnapshot() {
  return storage.getStore()?.snapshot;
}
