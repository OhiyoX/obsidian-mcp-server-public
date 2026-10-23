// Shared row shape for the note-context link lists (U2 desktop parity).
//
// Desktop renders one link row as: chain icon + the full vault-relative path
// (allowed to wrap) + a muted single-line parent-directory subline. Both the
// outgoing and incoming views and the unlinked-mention chips reuse these helpers
// so the three surfaces cannot drift apart.
//
// Safety: only textContent and validated attributes are used; there is no raw-HTML
// sink here.

import { spriteIcon } from "../../ui/icons.js";

// Desktop labels a link with its `alias` when it has one; the row text, however, is
// the full vault-relative path (U2), so the alias only stays reachable through the
// row tooltip: `alias (path)`. An alias is untrusted text and never enters the visible
// label; without one the tooltip is exactly the path the row already shows.
export function rowTitle(base, alias = null) {
  const value = String(base ?? "");
  const label = String(alias ?? "").trim();
  return label ? `${label} (${value})` : value;
}

// Parent directory of a vault-relative path, or null when the path has no parent
// (a root-level file, or a bare target such as a URL or an unresolved name).
export function parentDirOf(value) {
  const normalized = String(value ?? "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return null;
  return normalized.slice(0, index);
}

// Desktop renders a note link without its `.md` extension (Obsidian's display form);
// assets/external targets keep their path verbatim.
export function stripNoteExtension(value) {
  return String(value ?? "").replace(/\.md$/i, "");
}

// The existing sprite symbol is reused for every row; the desktop panel uses one chain
// glyph for links and backlinks alike. U38 (#571): the URL comes from ui/icons.js.
export function rowIcon(doc, className = "svg-icon context-row-icon") {
  return spriteIcon(doc, "link", className);
}

// The icon + main text + optional parent subline, ready to append into a row
// control (`button`/`a`/inert `span`). `mainClass` lets each view keep its own
// label class for compatibility with the existing selectors.
export function rowContent(documentRef, { text, parent = null, mainClass = "context-row-main" } = {}) {
  const icon = rowIcon(documentRef);
  const body = documentRef.createElement("span");
  body.className = "context-row-body";
  const main = documentRef.createElement("span");
  main.className = mainClass;
  main.textContent = String(text ?? "");
  body.append(main);
  if (parent) {
    const sub = documentRef.createElement("span");
    sub.className = "context-row-parent";
    sub.textContent = String(parent);
    body.append(sub);
  }
  const parts = [];
  if (icon) parts.push(icon);
  parts.push(body);
  return parts;
}
