// Vault-relative path identity for the Explorer: normalize a path, and decide whether
// two paths denote the same note.
//
// Both the Tree (lazy) and the flat list select "the current note" with this rule, so it
// lives in one module instead of being copied into `controller.js`: the controller
// injects `isSameNotePath` into flat mode and uses it for the tree/search selection.
// Pure: no DOM, no model, no fetch.
//
// NOT the same normalizer as `lazy-model.js`'s private one: that one additionally strips
// trailing slashes because a *parent key* must never differ by a trailing "/". Note
// identity here stays literal (the server's path is the identity), so the two must not be
// merged without re-checking the tree key semantics.
export function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

// Notes compare with the `.md` suffix optional; any other row kind (base/attachment) is
// an exact path comparison at the call site, never through this `.md`-stripping rule.
export function isSameNotePath(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.replace(/\.md$/i, "") === b.replace(/\.md$/i, "");
}
