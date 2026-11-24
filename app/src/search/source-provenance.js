// Source provenance and index freshness (issue #666).
//
// This module is the single owner of one answer: where does this text come from,
// and is that still the file's text? It is pure — no clock, no filesystem, no
// index access. Every fact arrives as evidence from the adapter that holds it, so
// `freshness: "current"` can only rest on evidence the caller really observed.
//
// A `current` claim needs all of:
//   * a source revision and an index revision, equal: the index describes the same
//     bytes the source was observed with;
//   * an index generation that the index itself can name as current. A caller
//     passes it only for a snapshot that is not behind its own generation, so text
//     that an index still holds without one is `lagging`, never `current`;
//   * no source mtime that went backwards relative to the mtime the index recorded.
// Everything else is `lagging` (the text is behind the source) or `unknown` (the
// evidence needed to compare is missing: deleted or moved file, permission denial,
// an untrusted clock, an index that cannot name itself). A date is emitted only
// when it was observed — the process clock is never a source modification date —
// and no `ageDays`/`stale` field exists without an explicit clock and policy.
//
// Cross-Vault isolation: the DTO echoes the Vault it was built for and the path
// inside that Vault. A vault-relative path is required (an absolute or escaping
// path is refused), only the index side's revision is ever echoed, and a revision
// from another Vault can therefore never become proof of `current`.

/** The only freshness values a caller may see. */
export const FRESHNESS = Object.freeze(["current", "lagging", "unknown"]);

/** The frozen DTO field set; `freshness` is always present, the rest are evidence. */
export const PROVENANCE_FIELDS = Object.freeze([
  "vaultId", "path", "revision", "modifiedAt", "indexGeneration", "freshness", "reason",
]);

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`source provenance requires a non-empty ${name} string`);
  return value;
}

// A Vault-relative path only: `/vault-b/Notes/X.md`, `../vault-b/X.md`, `Notes\X.md`
// and `Notes//X.md` are another Vault's fact, not this one's, and are refused.
function vaultRelativePath(value) {
  const notePath = requireText(value, "path");
  if (notePath.startsWith("/") || notePath.includes("\\")) throw new TypeError(`source provenance needs a vault-relative path, got ${JSON.stringify(notePath)}`);
  if (notePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError(`source provenance needs a vault-relative path without empty, "." or ".." segments, got ${JSON.stringify(notePath)}`);
  }
  return notePath;
}

// `undefined`/`null` means "no generation can be named"; a malformed one is a caller bug.
function optionalGeneration(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`indexGeneration must be a non-negative integer, got ${String(value)}`);
  return value;
}

function optionalRevision(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string when provided`);
  return value;
}

// An observed instant, kept exactly as observed. A malformed one is signalled
// separately because a clock that cannot be trusted must not support `current`.
function parseInstant(value) {
  if (value === undefined || value === null) return { state: "absent" };
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return { state: "invalid" };
  return { state: "observed", value };
}

function verdict(freshness, reason) {
  return { freshness, reason };
}

function freshnessFor(evidence) {
  const { indexGeneration, sourceRevision, indexedRevision, sourceModifiedAt, indexedModifiedAt } = evidence;
  if (sourceRevision !== undefined && indexedRevision !== undefined && sourceRevision !== indexedRevision) return verdict("lagging", "index_content_stale");
  if (indexGeneration === undefined) {
    return indexedRevision !== undefined ? verdict("lagging", "index_generation_stale") : verdict("unknown", "index_evidence_unavailable");
  }
  if (indexedRevision === undefined) {
    return sourceRevision === undefined ? verdict("unknown", "source_not_verified") : verdict("lagging", "not_indexed");
  }
  if (sourceRevision === undefined) return verdict("unknown", "source_not_verified");
  if (sourceModifiedAt.state === "invalid") return verdict("unknown", "source_modified_at_invalid");
  if (sourceModifiedAt.value !== undefined && indexedModifiedAt.value !== undefined && Date.parse(sourceModifiedAt.value) < Date.parse(indexedModifiedAt.value)) {
    return verdict("lagging", "source_mtime_regressed");
  }
  return verdict("current");
}

/**
 * Build one source-provenance DTO.
 *
 * Every input is evidence, in the form the caller observed it:
 *   vaultId            — the Vault this answer belongs to (required, echoed);
 *   path               — the vault-relative path inside that Vault (required, echoed);
 *   sourceRevision     — revision of the source bytes the caller observed directly;
 *   sourceModifiedAt   — the source's mtime from that same observation;
 *   indexGeneration    — the index generation of the snapshot that produced the
 *                        text, only when that generation is the index's current one;
 *   indexedRevision    — the revision the index holds for this path (echoed as `revision`);
 *   indexedModifiedAt — the mtime the index recorded, used only to detect a
 *                        source mtime that went backwards.
 */
export function buildSourceProvenance(input = {}) {
  const vaultId = requireText(input.vaultId, "vaultId");
  const notePath = vaultRelativePath(input.path);
  const indexGeneration = optionalGeneration(input.indexGeneration);
  const sourceRevision = optionalRevision(input.sourceRevision, "sourceRevision");
  const indexedRevision = optionalRevision(input.indexedRevision, "indexedRevision");
  const sourceModifiedAt = parseInstant(input.sourceModifiedAt);
  const indexedModifiedAt = parseInstant(input.indexedModifiedAt);

  const provenance = { vaultId, path: notePath };
  if (indexedRevision !== undefined) provenance.revision = indexedRevision;
  if (sourceModifiedAt.state === "observed") provenance.modifiedAt = sourceModifiedAt.value;
  if (indexGeneration !== undefined) provenance.indexGeneration = indexGeneration;

  const result = freshnessFor({ indexGeneration, sourceRevision, indexedRevision, sourceModifiedAt, indexedModifiedAt });
  provenance.freshness = result.freshness;
  if (result.reason !== undefined) provenance.reason = result.reason;
  return provenance;
}
