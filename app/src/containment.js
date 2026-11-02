// Issue #734 — the one containment predicate.
//
// `path.relative()` answers `..` for "the parent directory itself" and `../x` for "below the parent",
// but it *also* answers `..name` for a legitimate sibling file called `..name`. Testing
// `relative.startsWith("..")` therefore rejects real files, and because the batch layer builds temp
// names from the target's basename, a root-level dotfile (`.gitignore` → `..gitignore….tmp`) was
// mistaken for an escape *after* the mutation had already been applied.
//
// Only these leave the root:
//   * an absolute relative path (`path.isAbsolute`, e.g. a different drive letter);
//   * exactly `..`;
//   * `..` followed by a separator (`../x`, `..\x` on Windows).
//
// Kept dependency-free (`node:path` only) so pure modules — the Vault registry in particular — can use
// it without pulling in config or any I/O.
import path from "node:path";

export function escapesRoot(relative) {
  if (path.isAbsolute(relative)) return true;
  if (relative === "..") return true;
  return relative.startsWith(`..${path.sep}`);
}
