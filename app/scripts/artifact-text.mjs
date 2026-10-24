// Shared text-equivalence check for generated Markdown artifacts.
//
// `cost-gate.md` and `runtime-matrix.md` are generated with `\n` line endings and
// committed that way. A Windows checkout with `core.autocrlf=true` materializes the
// same committed blob with `\r\n`, so a byte-for-byte comparison of the worktree file
// against the freshly rendered string fails on checkout format alone (observed as a
// real `release.py publish` gate failure). Verification therefore folds CRLF to LF
// before comparing.
//
// Only CRLF is normalized. Everything else stays a real difference, so this does not
// weaken the artifact gate: trailing whitespace, an added/removed word, an appended
// line, a missing or extra final newline, and a leading UTF-8 BOM all still fail.
// A lone `\r` (old-Mac ending) is intentionally not folded, so a stray carriage
// return inside a line cannot be hidden as "just a line ending".

export function normalizeArtifactEol(text) {
  return text.replace(/\r\n/g, "\n");
}

// Returns null when `actual` is equivalent to `expected` modulo CRLF<->LF, otherwise a
// human-readable reason string. A leading BOM is reported explicitly rather than being
// silently stripped as if it were an unknown (EOL) edit.
export function generatedArtifactMismatch(actual, expected) {
  if (actual === expected) return null;
  if (normalizeArtifactEol(actual) === expected) return null;
  if (actual.charCodeAt(0) === 0xfeff) return "leading UTF-8 BOM is not part of the generated artifact";
  return "content differs from the freshly generated artifact";
}
