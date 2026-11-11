// `src/publish/visibility.js` — the one decision for folder publishing.
//
// A note's own `publish:` frontmatter overrides the folder it sits in, so every
// surface (Web, MCP, PublishService) must agree on what that marker means and on
// what wins. This module owns that decision once. It is pure and IO-free: the
// caller reads the frontmatter and the path segments.

// Marker readings, as a frozen table so callers can compare without string drift.
export const PUBLISH_MARKER = Object.freeze({
  PUBLIC: "public",
  PRIVATE: "private",
  NONE: "none",
});

const DRAFT_PREFIXES = [".", "_"];

// Fail closed: an unrecognised `publish:` value (or unreadable data) hides the note.
// Caller contract: no frontmatter means `{}`, not `undefined`; `undefined` hides the note.
export function readPublishMarker(data) {
  if (!data || typeof data !== "object") return PUBLISH_MARKER.PRIVATE;
  if (data.private === true) return PUBLISH_MARKER.PRIVATE;
  if (data.publish === true) return PUBLISH_MARKER.PUBLIC;
  if (data.publish === false) return PUBLISH_MARKER.PRIVATE;
  if (data.publish === "public") return PUBLISH_MARKER.PUBLIC;
  if (data.publish === "private") return PUBLISH_MARKER.PRIVATE;
  if (data.publish === undefined) return PUBLISH_MARKER.NONE;
  return PUBLISH_MARKER.PRIVATE;
}

// Vault convention: `.obsidian` and `_drafts` are working directories, not notes.
export function isDraftSegment(name) {
  const value = String(name ?? "");
  return value.length > 0 && DRAFT_PREFIXES.includes(value[0]);
}

// Precedence: an explicit marker wins, then the draft subtree, then the folder.
export function visibilityOf({ marker, insidePublishedFolder, inDraftSubtree }) {
  if (marker === PUBLISH_MARKER.PRIVATE) return "hidden";
  if (marker === PUBLISH_MARKER.PUBLIC) return "visible";
  if (inDraftSubtree) return "hidden";
  return insidePublishedFolder ? "visible" : "hidden";
}
