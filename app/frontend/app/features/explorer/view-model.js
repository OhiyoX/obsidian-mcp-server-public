// Explorer view model — the single derived Tree manifest.
//
// Both the renderer and the DOM-reuse equality check consume the exact same
// grouping + sorting result produced here. The grouping/sorting itself is fully
// delegated to the frozen `sortTreeLevel()` pure model: this file never writes a
// second name/modified comparator.
//
// A view is `{ spec, root }` where `root` is a recursive
// `{ folders: [{ name, path, children }], notes: [note] }`. `explorerViewSignature`
// (spec + observable content) is the DOM-reuse identity; `explorerViewContentSignature`
// (observable content only) is used to decide whether a sort change actually
// reorders the Tree. Neither signature includes backend input order, `score`,
// `tags`, or anything the Tree does not visibly render.

import { sortTreeLevel } from "./sort-model.js";
import { coerceExplorerSort } from "./sort-preference.js";

function groupNotes(notes) {
  const root = { children: new Map(), notes: [] };
  for (const note of notes || []) {
    const parts = String(note?.path ?? "").split("/");
    let node = root;
    for (const segment of parts.slice(0, -1)) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map(), notes: [] });
      node = node.children.get(segment);
    }
    node.notes.push(note);
  }
  return root;
}

function buildNode(group, prefix, spec) {
  const folderEntries = [];
  for (const [name, child] of group.children) {
    folderEntries.push({ name, path: prefix ? `${prefix}/${name}` : name, child });
  }
  const ordered = sortTreeLevel({ folders: folderEntries, notes: group.notes }, spec);
  return {
    folders: ordered.folders.map((entry) => ({
      name: entry.name,
      path: entry.path,
      children: buildNode(entry.child, entry.path, spec),
    })),
    notes: ordered.notes.slice(),
  };
}

export function buildExplorerView(notes, sort) {
  const spec = coerceExplorerSort(sort);
  return { spec, root: buildNode(groupNotes(notes), "", spec) };
}

// Mirrors exactly what the renderer puts in the note title element
// (`escapeHtml(note.title)` stringifies, so `String(note?.title)` is the
// deterministic label identity).
function noteLabel(note) {
  return String(note?.title);
}

// Structured, typed, ordered tuples. A JSON array is unambiguous: a field that
// contains `|`, `\u0001`, or any other delimiter cannot be confused with an
// adjacent tuple, unlike the previous raw pipe/newline concatenation.
function walkContent(node, depth, entries) {
  for (const folder of node.folders) {
    entries.push(["F", depth, String(folder.path ?? ""), String(folder.name ?? "")]);
    walkContent(folder.children, depth + 1, entries);
  }
  for (const note of node.notes) {
    entries.push(["N", depth, String(note?.path ?? ""), noteLabel(note)]);
  }
  return entries;
}

function contentEntries(view) {
  return walkContent(view?.root ?? { folders: [], notes: [] }, 0, []);
}

export function explorerViewContentSignature(view) {
  return JSON.stringify(contentEntries(view));
}

export function explorerViewSignature(view) {
  const spec = view?.spec ?? {};
  return JSON.stringify([String(spec.key ?? ""), String(spec.direction ?? ""), contentEntries(view)]);
}
