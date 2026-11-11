// `src/publish/materialize.js` — one registry record per `publish: true` note.
//
// Owner rule: a note that carries `publish: true` is visible anywhere, even inside a
// folder that is not published. It must therefore own a document record, because that
// record is the address. This module keeps that record in step with the marker.
//
// The trigger is a note read through the Web Catalog source (indexing), never a public
// read: serving a published note must not write. `publish()` writes the publish state
// file, not a note, so nothing here can call back into the note-write path.
import { READ_ONLY } from "../config.js";
import { setCatalogNoteReadObserver } from "../app/web-catalog/runtime.js";
import { PUBLISH_LIFECYCLE, PUBLISH_RECORD_KINDS } from "./lifecycle.js";
import { publishService as defaultPublishService } from "./service.js";
import { PUBLISH_MARKER, readPublishMarker } from "./visibility.js";

export const PUBLISH_SYNC_OUTCOME = Object.freeze({
  CREATED: "created",
  RETIRED: "retired",
  UNCHANGED: "unchanged",
});

// `vault` is an id or a vault object. Returns what changed, so a caller can log it and
// a test can assert idempotency.
//
// A note over `MAX_READ_BYTES` is metadata-only in the reconcile and never reaches this
// trigger, so its marker stays unknown and it gets no record: fail closed, by design.
export async function syncNotePublishRecord({ service, vault, relPath, data }) {
  const vaultId = typeof vault === "string" ? vault : vault?.id;
  const notePath = String(relPath ?? "");
  const marker = readPublishMarker(data);
  if (marker === PUBLISH_MARKER.PUBLIC) {
    // An active record already answers on its own address. Asking again must not rewrite
    // the whole state file, and one index pass reads every note.
    const { record } = await service.status(vaultId, notePath);
    if (record?.lifecycle === PUBLISH_LIFECYCLE.ACTIVE) return PUBLISH_SYNC_OUTCOME.UNCHANGED;
    // `publish()` replaces a retired record with a fresh id, so a dead record never blocks.
    const published = await service.publish(vaultId, notePath);
    return published?.created ? PUBLISH_SYNC_OUTCOME.CREATED : PUBLISH_SYNC_OUTCOME.UNCHANGED;
  }
  // Only "private" retires. "none" is no opinion: an explicit record is itself a decision
  // (someone asked for that address), so a sweep must never delete it. The listing rules
  // stay fail-closed; they just never destroy a record the note does not disown.
  if (marker !== PUBLISH_MARKER.PRIVATE) return PUBLISH_SYNC_OUTCOME.UNCHANGED;
  // Only a present record can change state, so a missing one writes nothing.
  // The kind is stated: a folder record named like the note's stem must never be revoked here.
  const result = await service.revoke(vaultId, notePath, { kind: PUBLISH_RECORD_KINDS.DOCUMENT });
  return result?.revoked ? PUBLISH_SYNC_OUTCOME.RETIRED : PUBLISH_SYNC_OUTCOME.UNCHANGED;
}

// A read-only deployment must not write the publish state while it indexes, so it installs
// no observer at all and clears any one already set. The Web face (`createWebAppRouter`)
// calls this once, with the registry it serves; the defaults are this module's own wiring.
// Returns whether it installed one.
export function installNoteReadMaterializer({ service = defaultPublishService, readOnly = READ_ONLY } = {}) {
  if (readOnly) {
    setCatalogNoteReadObserver(null);
    return false;
  }
  setCatalogNoteReadObserver((vault, read) => syncNotePublishRecord({
    service,
    vault,
    relPath: read.path,
    data: read.frontmatter,
  }));
  return true;
}
